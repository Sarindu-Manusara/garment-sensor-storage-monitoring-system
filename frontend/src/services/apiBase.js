const configuredApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

export function toApiUrl(path) {
  if (!path.startsWith("/")) {
    throw new Error(`API paths must start with "/". Received: ${path}`);
  }

  if (!configuredApiBaseUrl) {
    return path;
  }

  return `${configuredApiBaseUrl}${path}`;
}

export function getApiBaseUrl() {
  return configuredApiBaseUrl;
}
