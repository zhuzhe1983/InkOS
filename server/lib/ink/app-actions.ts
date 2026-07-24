export const INKOS_CLIENT_APP_URLS = [
  "inkos://app/random-image",
  "inkos://app/baidu-map",
] as const;

/** Exact device-local actions. They are never sent to the source fetcher. */
export const INKOS_CLIENT_DEVICE_URLS = [
  "inkos://device/settings",
] as const;

export type InkClientDeviceUrl = typeof INKOS_CLIENT_DEVICE_URLS[number];

export function isInkClientDeviceUrl(value: string): value is InkClientDeviceUrl {
  return (INKOS_CLIENT_DEVICE_URLS as readonly string[]).includes(value);
}

export type InkClientAppUrl = typeof INKOS_CLIENT_APP_URLS[number];

/** Stable transient document identities shared by server and thin clients. */
export const INKOS_APP_DOCUMENT_UUIDS: Readonly<Record<InkClientAppUrl, string>> = Object.freeze({
  "inkos://app/random-image": "50605ede-b09d-5de8-8615-a718d3a5605b",
  "inkos://app/baidu-map": "cdcdc6c5-5773-549a-b3c8-5b4363bf9a35",
});

export function isInkClientAppUrl(value: string): value is InkClientAppUrl {
  return (INKOS_CLIENT_APP_URLS as readonly string[]).includes(value);
}
