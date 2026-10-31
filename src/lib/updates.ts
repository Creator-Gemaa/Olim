export const APP_VERSION = '1.0.6';

export const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/Creator-Gemaa/Olim/vyra-latest/public/version.json';

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  androidDownloadUrl: string;
  windowsDownloadUrl: string;
  releaseUrl: string;
};

function parseVersion(value: string): { major: number; minor: number; patch: number; prerelease: string | null } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) throw new Error('The update server returned an invalid version number.');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

function isOfficialReleaseAsset(value: unknown, filename: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname === `/Creator-Gemaa/Olim/releases/download/vyra-latest/${filename}`;
  } catch {
    return false;
  }
}

export async function checkLatestUpdate(): Promise<UpdateCheckResult> {
  const response = await fetch(`${UPDATE_MANIFEST_URL}?check=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Could not reach the VYRA update server (HTTP ${response.status}).`);

  const manifest: unknown = await response.json();
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('The VYRA update manifest is invalid.');
  }

  const data = manifest as Record<string, unknown>;
  if (typeof data.version !== 'string') {
    throw new Error('The VYRA update manifest does not include a version.');
  }
  const latestVersion = data.version.trim();
  const available = compareVersions(APP_VERSION, latestVersion) < 0;

  const androidDownloadUrl = data.androidDownloadUrl;
  const windowsDownloadUrl = data.windowsDownloadUrl;
  const releaseUrl = data.releaseUrl;
  if (!isOfficialReleaseAsset(androidDownloadUrl, 'VYRA-Android.apk') ||
      !isOfficialReleaseAsset(windowsDownloadUrl, 'VYRA-Setup.exe') ||
      typeof releaseUrl !== 'string' ||
      !releaseUrl === 'https://github.com/Creator-Gemaa/Olim/releases/tag/vyra-latest') {
    throw new Error('The VYRA update manifest contains an unexpected download link.');
  }

  return {
    currentVersion: APP_VERSION,
    latestVersion,
    available,
    androidDownloadUrl,
    windowsDownloadUrl,
    releaseUrl,
  };
}
