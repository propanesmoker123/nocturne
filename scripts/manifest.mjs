// Builds latest.json for the Tauri updater (static GitHub Releases endpoint).

/** "https://github.com/<owner>/<repo>/releases/latest/download/latest.json" → "<owner>/<repo>" */
export function repoFromEndpoint(endpoint) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download\/latest\.json$/.exec(endpoint)
  if (!m) throw new Error(`Updater endpoint is not a GitHub release URL: ${endpoint}`)
  return `${m[1]}/${m[2]}`
}

export function buildManifest({ version, notes, pubDate, repo, file, signature }) {
  return {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/${repo}/releases/download/v${version}/${file}`,
      },
    },
  }
}
