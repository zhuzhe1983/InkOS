# InkOS service health checkpoints

These checks distinguish a listening Next.js process from a usable InkOS
renderer/package service. Run them against the same origin used by clients,
for example `http://127.0.0.1:3000` or the LAN address.

## Critical checkpoints

1. `GET /papers3-client` returns `200`, and every referenced `/_next/static/*`
   stylesheet/script returns `200` rather than a stale-build `500`.
2. `GET /api/ink/v1/packages` returns `inkos.package-catalog/v1`; its
   `defaultPackageId` exists in `packages` and that entry's `entryUuid` equals
   `defaultEntryUuid`.
3. The default manifest, entry document, entry frame and entry sidecar return
   `200`, correct content types, declared lengths and matching SHA-256 headers.
4. The default manifest declares the PaperS3 `gray4` profile and exact portrait
   and landscape base frames. The built-in home currently declares those two
   tuples, eight application hitboxes (including 图片查看器 and 百度地图), plus the
   top-right settings hitbox. It does not enumerate font combinations and never
   declares an inverse variant.
5. In a firmware-paired deployment, the default download is byte-for-byte equal
   to that release's embedded `home.ink`; catalog bytes/SHA and the downloaded
   archive must agree. Set `INKOS_PAPERS3_HOME_ARCHIVE` to that trusted release
   artifact so a valid but byte-different package is atomically replaced and the
   pinned release remains valid after the server's wall-clock date advances.
6. A manifest-bound `POST /api/ink/v1/packages/{packageId}/render` for a missing
   PaperS3 display tuple returns a decodable PNG plus matching frame/sidecar
   headers. Missing precondition returns `428`; a stale manifest hash returns
   `412`; the web client reloads the same manifest and retries once without
   replacing its current frame before the refreshed result is fully verified.
7. `GET /api/ink/v1/openapi.json` and `GET /api/device-profiles` return parseable
   contracts containing the package-render endpoint and PaperS3 profile.
8. `POST /api/ink/v1/apps/execute` with the exact image-viewer action returns a
   no-store verified PNG and echoes action, nonce, timestamp and page index. A
   photo response declares
   `X-Ink-App-Image-Mode: photo-papers3-slideshow-gray16-rgb-png-v3`;
   inspect IHDR for bit depth 8 and colour type 2/6, confirm there is no `PLTE`,
   and verify every neutral-RGB sample is one of the stable centres
   `8, 24, …, 248` and maps to the same native level at every Bayer position.
   A known photo should also exercise the 0.5% two-ended autocontrast,
   contrast 1.08, radius-1/65%/threshold-3 unsharp mask and serpentine
   Floyd-Steinberg stages.
   A successful map response instead declares
   `diagnostic-raw-colour-png-v1` and must preserve decoded map pixels.
   Standard package PNGs must remain indexed gray4.
   A
   suffixed action is `400`; the map action is a sanitized `503` when
   `INKOS_BAIDU_MAP_AK` is unset. Test a live map only in an environment where
   that server-only secret is already injected; never print the request URL.

## Additional checkpoints

- Submit one controlled HTTPS URL to `POST /api/ink/v1/sources/resolve`, observe
  a cached `200` or a progressing `202` job, and verify the completed revision 17
  draft. Confirm `X-InkOS-Source-Cache` is `hit`, `stale` or `miss`,
  `Server-Timing` contains `source_resolve`, and the job exposes bounded
  millisecond `timings`. This exercises Chromium, external DNS/network,
  Markdown conversion and rendering dependencies and is intentionally not a
  cheap liveness probe.
- After a cold realtime source completes, confirm a low-priority revision 18
  archive for the same package lineage is eventually published, and that a
  later manifest read selects the higher verified revision without changing the
  package ID.
- Resolve a deliberately stale test package and confirm the API returns its old
  verified manifest immediately with `stale: true` while a revalidation job is
  enqueued.
- Download the default `.ink`, run the archive verifier and confirm the archive
  package/entry IDs equal the catalog declaration.
- Open `/papers3-client` without content parameters and confirm the browser
  downloads that same archive, verifies it through the offline installer and
  displays its entry frame. In the offline panel, activate the built-in Demo and
  confirm it follows the same path as a local `.ink` selection.
- Open `/papers3-client?fullscreen=1` at portrait and landscape viewport sizes;
  confirm sensor/display changes request only the current missing frame and do
  not enqueue a multi-variant generator job.
- Check generator jobs for repeated retries, stuck progress, Chromium captures
  exceeding the 10-second deadline or unexpected variant fan-out. With default
  concurrency, a background archive must not consume the foreground slot.

## Known gap

The development service has no dedicated `/health` or `/ready` route. Until one
is added, the catalog/default-frame checks above are the readiness signal; an
open port or a successful root-page response alone is insufficient.
