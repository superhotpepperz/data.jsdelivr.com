const got = require('got');
const semver = require('semver');
const config = require('config');
const { Octokit } = require('@octokit/rest');
const promiseRetry = require('promise-retry');
const BadgeFactory = require('gh-badges').BadgeFactory;
const isSha = require('is-hexdigest');
const isSemverStatic = require('is-semver-static');
const vCompare = require('v-compare');
const NumberAbbreviate = require('number-abbreviate');
const number = new NumberAbbreviate([ 'k', 'M', 'B', 'T' ]);
const PromiseCacheShared = require('../../../lib/promise-cache-shared');
const fetchCache = new PromiseCacheShared('v1/pr');
const badgeFactory = new BadgeFactory();

const BaseRequest = require('./BaseRequest');
const Package = require('../../../models/Package');
const PackageListing = require('../../../models/PackageListing');
const PackageVersion = require('../../../models/PackageVersion');
const dateRange = require('../../utils/dateRange');
const sumDeep = require('../../utils/sumDeep');

const v1Config = config.get('v1');
const githubApi = new Octokit({
	auth: `token ${v1Config.gh.apiToken}`,
	baseUrl: v1Config.gh.sourceUrl,
	userAgent: 'jsDelivr API backend',
	request: {
		timeout: 30000,
	},
});

class PackageRequest extends BaseRequest {
	constructor (ctx) {
		super(ctx);

		this.keys = {
			metadata: `c:package/${this.params.type}/${this.params.name}/metadata`,
			rank: `package/${this.params.type}/${this.params.name}/rank/`,
		};
	}

	async fetchFiles () {
		let url = `${v1Config.cdn.sourceUrl}/${this.params.type}/${this.params.name}@${encodeURIComponent(this.params.version)}/+private-json`;

		return fetchCache.get(url, () => {
			return promiseRetry((retry) => {
				return got(url, { json: true, timeout: 30000 }).then((response) => {
					return _.pick(response.body, [ 'default', 'files' ]);
				}).catch((error) => {
					if (error instanceof got.HTTPError && error.response.statusCode === 403) {
						return {
							status: error.response.statusCode,
							message: error.response.body,
						};
					} else if (error instanceof got.ParseError) {
						return retry(error);
					}

					throw error;
				});
			}, { retries: 2 });
		});
	}

	async fetchMetadata () {
		if (this.params.type === 'npm') {
			return fetchNpmMetadata(this.params.name, v1Config[this.params.type].maxAge);
		} else if (this.params.type === 'gh') {
			return fetchGitHubMetadata(this.params.user, this.params.repo, v1Config[this.params.type].maxAge);
		}

		throw new Error(`Unknown package type ${this.params.type}.`);
	}

	async getFiles () {
		let files = JSON.parse(await this.getFilesAsJson());

		if (this.ctx.params.structure === 'flat' || !files.files) {
			return files;
		}

		let tree = [];
		let dirs = {};
		let fn = (entry, files = tree, dir = '/') => {
			let name = entry.name.substr(1);
			let index = name.indexOf('/');

			if (index !== -1) {
				let dirName = name.substr(0, index);
				let absDirName = dir + '/' + dirName;

				if (!{}.hasOwnProperty.call(dirs, absDirName)) {
					dirs[absDirName] = { type: 'directory', name: dirName, files: [] };

					// List directories before files.
					let firstFileIndex = files.findIndex(item => item.type === 'file');
					files.splice(firstFileIndex !== -1 ? firstFileIndex : 0, 0, dirs[absDirName]);
				}

				return fn({ name: entry.name.substr(index + 1), hash: entry.hash, time: entry.time, size: entry.size }, dirs[absDirName].files, absDirName);
			}

			files.push({
				type: 'file',
				name,
				hash: entry.hash,
				time: entry.time,
				size: entry.size,
			});
		};

		files.files.forEach(file => fn(file, tree));
		return { default: files.default, files: tree };
	}

	async getFilesAsJson () {
		let props = { type: this.params.type, name: this.params.name, version: this.params.version };
		let packageListing = await PackageListing.find(props);

		if (packageListing) {
			return packageListing.listing;
		}

		let listing = JSON.stringify(await this.fetchFiles());
		await new PackageListing({ ...props, listing }).insert().catch(() => {});
		return listing;
	}

	async getMetadata () {
		return this.fetchMetadata();
	}

	async getRank () {
		let stats = await Package.getStatsForPeriod(this.params.type, this.params.name, this.period, this.date);
		return stats ? stats.rank : null;
	}

	async getResolvedVersion () {
		return this.getMetadata().then((metadata) => {
			let versions = metadata.versions.filter(v => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);

			if (metadata.versions.includes(this.params.version)) {
				return this.params.version;
			} else if ({}.hasOwnProperty.call(metadata.tags, this.params.version)) {
				return metadata.tags[this.params.version];
			} else if (this.params.version === 'latest' || !this.params.version) {
				return versions[0] || null;
			}

			return semver.maxSatisfying(versions, this.params.version);
		});
	}

	async handleResolveVersion () {
		try {
			this.ctx.body = { version: await this.getResolvedVersion() };
			this.ctx.maxAge = v1Config.maxAgeShort;
			this.ctx.maxStale = v1Config.maxStaleShort;
			this.ctx.maxStaleError = v1Config.maxStaleErrorShort;

			if (this.ctx.body.version && isSemverStatic(this.params.version)) {
				this.ctx.maxAge = 24 * 60 * 60;
				this.ctx.maxStale = v1Config.maxStaleStatic;
				this.ctx.maxStaleError = v1Config.maxStaleStatic;
			}
		} catch (e) {
			return this.responseFromRemoteError(e);
		}
	}

	async handleVersions () {
		try {
			this.ctx.body = await this.getMetadata();
			this.ctx.maxAge = v1Config.maxAgeShort;
			this.ctx.maxStale = v1Config.maxStaleShort;
			this.ctx.maxStaleError = v1Config.maxStaleErrorShort;
		} catch (e) {
			return this.responseFromRemoteError(e);
		}
	}

	async handlePackageBadge () {
		let stats = await Package.getStatsForPeriod(this.params.type, this.params.name, this.period, this.date);
		let hits = stats ? stats.hits : 0;

		this.ctx.type = 'image/svg+xml; charset=utf-8';

		this.ctx.body = badgeFactory.create({
			text: [ 'jsDelivr', `${number.abbreviate(hits)} hits${this.period === 'all' ? '' : `/${this.period}`}` ],
			colorB: '#ff5627',
			template: this.ctx.query.style === 'rounded' ? 'flat' : 'flat-square',
		});

		this.setCacheHeaderDelayed();
	}

	async handlePackageStats () {
		if (this.params.groupBy === 'date') {
			let data = await Package.getSumDateHitsPerVersionByName(this.params.type, this.params.name, ...this.dateRange);
			let total = sumDeep(data, 3);

			this.ctx.body = {
				rank: total ? await this.getRank() : null,
				total,
				dates: dateRange.fill(_.mapValues(data, ({ versions, commits }) => ({ total: sumDeep(versions), versions, commits })), ...this.dateRange, { total: 0, versions: {}, commits: {} }),
			};
		} else {
			let data = await Package.getSumVersionHitsPerDateByName(this.params.type, this.params.name, ...this.dateRange);
			let total = sumDeep(data, 3);
			let fn = data => _.mapValues(data, dates => ({ total: sumDeep(dates), dates: dateRange.fill(dates, ...this.dateRange) }));

			this.ctx.body = {
				rank: total ? await this.getRank() : null,
				total,
				versions: fn(data.versions),
				commits: fn(data.commits),
			};
		}

		this.setCacheHeader();
	}

	async handleVersionFiles () {
		// Don't validate version if it's a commit hash.
		if (this.params.type !== 'gh' || !isSha(this.params.version, 'sha1')) {
			let metadata;

			try {
				metadata = await this.getMetadata();
			} catch (e) {
				return this.responseFromRemoteError(e);
			}

			if (!metadata.versions.includes(this.params.version)) {
				return this.ctx.body = {
					status: 404,
					message: `Couldn't find version ${this.params.version} for ${this.params.name}. Make sure you use a specific version number, and not a version range or an npm tag.`,
				};
			}
		}

		try {
			this.ctx.body = await this.getFiles(); // Can't use AsJson() version here because we need to set correct status code on cached errors.
			this.ctx.maxAge = v1Config.maxAgeStatic;
			this.ctx.maxStale = v1Config.maxStaleStatic;
		} catch (error) {
			if (error instanceof got.RequestError || error instanceof got.TimeoutError) {
				return this.ctx.status = error.code === 'ETIMEDOUT' ? 504 : 502;
			} else if (error instanceof got.HTTPError) {
				return this.ctx.body = {
					status: error.response.statusCode || 502,
					message: error.response.body,
				};
			}

			throw error;
		}
	}

	async handleVersionStats () {
		if (this.params.groupBy === 'date') {
			let data = await PackageVersion.getSumDateHitsPerFileByName(this.params.type, this.params.name, this.params.version, ...this.dateRange);

			this.ctx.body = {
				total: sumDeep(data, 2),
				dates: dateRange.fill(_.mapValues(data, files => ({ total: sumDeep(files), files })), ...this.dateRange, { total: 0, files: {} }),
			};
		} else {
			let data = await PackageVersion.getSumFileHitsPerDateByName(this.params.type, this.params.name, this.params.version, ...this.dateRange);

			this.ctx.body = {
				total: sumDeep(data, 2),
				files: _.mapValues(data, dates => ({ total: sumDeep(dates), dates: dateRange.fill(dates, ...this.dateRange) })),
			};
		}

		this.setCacheHeader();
	}

	async responseFromRemoteError (error) {
		this.ctx.body = {
			status: error.response && error.response.statusCode === 404
				? 404
				: error instanceof got.TimeoutError || error.code === 'ETIMEDOUT'
					? 504
					: 502,
			message: this.params.version ? `Couldn't find ${this.params.name}@${this.params.version}.` : `Couldn't fetch versions for ${this.params.name}.`,
		};
	}
}

module.exports = PackageRequest;

/**
 * Fetches repo tags from GitHub.
 * @param {string} user
 * @param {string} repo
 * @param {number} maxAge
 * @return {Promise<Object>}
 */
async function fetchGitHubMetadata (user, repo, maxAge) {
	apmClient.addLabels({ githubUser: user });
	apmClient.addLabels({ githubRepo: repo });

	return fetchCache.get(`gh/${user}/${repo}`, (cache) => {
		return githubApi.paginate(githubApi.repos.listTags.endpoint.merge({ repo, owner: user, per_page: 100 })).then((data) => {
			apmClient.addLabels({ githubTagCount: data.length });

			data.forEach((tag) => {
				if (tag.name.charAt(0) === 'v') {
					tag.name = tag.name.substr(1);
				}
			});

			return { tags: [], versions: _.uniq(_.map(data, 'name').filter(v => v).sort(vCompare.rCompare)) };
		}).catch((error) => {
			// mimic got interface that's used in other places
			error.response = { statusCode: error.status };

			// istanbul ignore next
			if (error.status === 404) {
				apmClient.addLabels({ githubRepoNotFound: '1' });
				cache({ response: error.response }, maxAge * 2);
			}

			if (error.status === 403) {
				if (error.block) {
					cache({ response: error.response }, maxAge * 2);
				} else {
					log.error(`GitHub API rate limit exceeded.`, error);
				}
			}

			throw error;
		});
	}, maxAge);
}

/**
 * Sends a query to all configured registries and returns the first response.
 * @param {string} name
 * @param {number} maxAge
 * @return {Promise<Object>}
 */
async function fetchNpmMetadata (name, maxAge) {
	return fetchCache.get(`npm/${name}`, async (cache) => {
		name = name.charAt(0) === '@' ? '@' + encodeURIComponent(name.substr(1)) : encodeURIComponent(name);
		let promise;

		if (typeof v1Config.npm.sourceUrl === 'string') {
			promise = got(`${v1Config.npm.sourceUrl}/${name}`, { json: true, timeout: 30000 });
		} else {
			promise = Bluebird.any(_.map(v1Config.npm.sourceUrl, (sourceUrl) => {
				return got(`${sourceUrl}/${name}`, { json: true, timeout: 30000 });
			})).catch((e) => {
				throw e[0]; // throw one of the original errors instead of bluebird's AggregateError
			});
		}

		let response = await promise.catch((error) => {
			if (error.response && error.response.statusCode === 404) {
				cache({ response: { statusCode: error.response.statusCode } });
			}

			throw error;
		});

		if (!response.body || !response.body.versions) {
			throw new Error(`Unable to retrieve versions for package ${name}.`);
		}

		return {
			tags: response.body['dist-tags'],
			versions: Object.keys(response.body.versions).sort(semver.rcompare),
		};
	}, maxAge);
}

setTimeout(() => {
	if (apmClient.isStarted()) {
		let remaining = 0;

		setInterval(() => {
			githubApi.rateLimit.get().then((response) => {
				remaining = response.data.resources.core.remaining;
			}).catch(() => {});
		}, 30 * 1000);

		setTimeout(() => {
			apmClient.registerMetric('github.remaining', () => {
				return remaining;
			});
		}, 40 * 1000);
	}
}, 10 * 1000);
