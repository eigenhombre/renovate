import { logger } from '../../logger';
import { ExternalHostError } from '../../types/errors/external-host-error';
import { clone } from '../../util/clone';
import { getElapsedMinutes } from '../../util/date';
import { Http } from '../../util/http';
import type { GetReleasesConfig, Release, ReleaseResult } from '../types';
import { id } from './common';
import type {
  JenkinsCache,
  JenkinsCacheTypes,
  JenkinsPluginsInfoResponse,
  JenkinsPluginsVersionsResponse,
} from './types';

const http = new Http(id);

const packageInfoUrl =
  'https://updates.jenkins.io/current/update-center.actual.json';
const packageVersionsUrl =
  'https://updates.jenkins.io/current/plugin-versions.json';

function hasCacheExpired(cache: JenkinsCache<JenkinsCacheTypes>): boolean {
  return getElapsedMinutes(cache.lastSync) >= cache.cacheTimeMin;
}

async function updateJenkinsCache(
  cache: JenkinsCache<JenkinsCacheTypes>,
  updateHandler: () => Promise<void>
): Promise<void> {
  if (hasCacheExpired(cache)) {
    cache.updatePromise =
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      cache.updatePromise || updateHandler();
    await cache.updatePromise;

    cache.updatePromise = null;
  }
}

function updateJenkinsPluginInfoCacheCallback(
  response: JenkinsPluginsInfoResponse,
  cache: JenkinsCache<ReleaseResult>
): void {
  for (const name of Object.keys(response.plugins || [])) {
    cache.cache[name] = {
      releases: [], // releases are stored in another cache
      sourceUrl: response.plugins[name]?.scm,
    };
  }
}

function updateJenkinsPluginVersionsCacheCallback(
  response: JenkinsPluginsVersionsResponse,
  cache: JenkinsCache<Release[]>
): void {
  const plugins = response.plugins;
  for (const name of Object.keys(plugins || [])) {
    cache.cache[name] = Object.keys(plugins[name]).map((version) => ({
      version,
      downloadUrl: plugins[name][version]?.url,
      releaseTimestamp: plugins[name][version]?.buildDate
        ? new Date(plugins[name][version].buildDate + ' UTC')
        : null,
    }));
  }
}

async function getJenkinsUpdateCenterResponse<T>(
  cache: JenkinsCache<JenkinsCacheTypes>
): Promise<T> {
  let response: T;

  const options = {
    headers: {
      'Accept-Encoding': 'gzip, deflate, br',
    },
  };

  try {
    logger.debug(`jenkins-plugins: Fetching Jenkins plugins ${cache.name}`);
    const startTime = Date.now();
    response = (await http.getJson<T>(cache.dataUrl, options)).body;
    const durationMs = Math.round(Date.now() - startTime);
    logger.debug(
      { durationMs },
      `jenkins-plugins: Fetched Jenkins plugins ${cache.name}`
    );
  } catch (err) /* istanbul ignore next */ {
    cache.cache = Object.create(null);
    throw new ExternalHostError(
      new Error(`jenkins-plugins: Fetch plugins ${cache.name} error`)
    );
  }

  return response;
}

async function updateJenkinsPluginCache<T>(
  cache: JenkinsCache<JenkinsCacheTypes>,

  callback: (resp: T, cache: JenkinsCache<any>) => void
): Promise<void> {
  const response = await getJenkinsUpdateCenterResponse<T>(cache);
  if (response) {
    callback(response, cache);
  }
  cache.lastSync = new Date();
}

const pluginInfoCache: JenkinsCache<ReleaseResult> = {
  name: 'info',
  dataUrl: packageInfoUrl,
  lastSync: new Date('2000-01-01'),
  cacheTimeMin: 1440,
  cache: Object.create(null),
};

const pluginVersionsCache: JenkinsCache<Release[]> = {
  name: 'versions',
  dataUrl: packageVersionsUrl,
  lastSync: new Date('2000-01-01'),
  cacheTimeMin: 60,
  cache: Object.create(null),
};

async function updateJenkinsPluginInfoCache(): Promise<void> {
  await updateJenkinsPluginCache<JenkinsPluginsInfoResponse>(
    pluginInfoCache,
    updateJenkinsPluginInfoCacheCallback
  );
}

async function updateJenkinsPluginVersionsCache(): Promise<void> {
  await updateJenkinsPluginCache<JenkinsPluginsVersionsResponse>(
    pluginVersionsCache,
    updateJenkinsPluginVersionsCacheCallback
  );
}

export async function getJenkinsPluginDependency(
  lookupName: string
): Promise<ReleaseResult | null> {
  logger.debug(`getJenkinsDependency(${lookupName})`);
  await updateJenkinsCache(pluginInfoCache, updateJenkinsPluginInfoCache);
  await updateJenkinsCache(
    pluginVersionsCache,
    updateJenkinsPluginVersionsCache
  );

  const plugin = pluginInfoCache.cache[lookupName];
  if (!plugin) {
    return null;
  }

  const result = clone(plugin);
  const releases = pluginVersionsCache.cache[lookupName];
  result.releases = releases ? clone(releases) : [];
  return result;
}

export function getReleases({
  lookupName,
}: GetReleasesConfig): Promise<ReleaseResult | null> {
  return getJenkinsPluginDependency(lookupName);
}

function resetJenkinsCache(cache: JenkinsCache<JenkinsCacheTypes>): void {
  cache.lastSync = new Date('2000-01-01');
  cache.cache = Object.create(null);
}

// Note: use only for tests
export function resetCache(): void {
  resetJenkinsCache(pluginInfoCache);
  resetJenkinsCache(pluginVersionsCache);
}
