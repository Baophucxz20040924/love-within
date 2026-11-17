# Post photos and videos

Applies to couple Stories and Hội bạn bè posts only. Avatars, moments, event covers and other photo-only features retain their existing upload contracts.

## Browser selection

Post composers prepare selected files before enabling submission. Images with missing/octet-stream MIME can be recognized from common file signatures/extensions, but must still decode successfully. Image input is capped at 30 MiB, resized to a maximum edge of 1600 pixels and re-encoded as JPEG (removing source EXIF/GPS), with a 5 MiB output cap. `createImageBitmap` has an HTML image decoder fallback. Files that cannot decode remain visible with a removable error; they do not silently vanish or occupy a valid attachment slot. Processing is sequential and stale results are ignored after removal/unmount/StrictMode replay. Preview object URLs belong to effects and are revoked by their cleanup.

HEIC/HEIF works only when the current browser has a native decoder. Unsupported files must be converted to JPEG/PNG outside the app. There is no bundled HEIC conversion service. Animated images become a still JPEG. Existing non-post image helpers are unchanged.

Video accepts browser-decodable MP4, WebM or modern QuickTime MOV, at most **one video and 50 MiB per post**. The combined image/video limit is ten. A decoded first frame, not only metadata, is required before posting. Playback depends on the browser and codec on both sender and viewer devices; MP4 H.264 is a suggested conversion target if decoding fails. No transcoding, duration probing, thumbnail generation or malware scanning is provided. Width/height are client display metadata, not server-verified media properties.

Images appear in the existing image grid/gallery; a separate controls-enabled inline video follows it. Mixed picker order is not preserved across those two groups. Video does not autoplay or auto-resume. It pauses on document hiding, viewport exit, unmount and realtime privacy masking (which retains the React tree).

## REST and persistence

Existing `photos[]` contracts and image upload endpoints remain unchanged. Story/FriendStory add `videos[]`, defaulting to `[]` for older documents. Each video is `{key, mimeType: 'video/mp4' | 'video/webm' | 'video/quicktime', width, height}`; read DTOs add a signed `url`.

- Create without `videos`: no videos.
- Edit without `videos`: preserve current videos, including in the combined-count/nonempty checks.
- Edit with `videos: []`: explicitly remove videos.
- Video-only posts are allowed. Mentions, polls and existing realtime invalidation/CAS behavior remain in place.

Separate `POST /api/stories/video-upload-url` and `POST /api/friends/stories/video-upload-url` use the existing context authentication/membership and upload limiters. Response: `{uploadUrl, videoKey, expiresIn, maxBytes}`. They accept MIME and positive integer `sizeBytes` up to 50 MiB. Keys are scoped to:

```
couples/<coupleId>/story-videos/YYYY-MM/<uuid>.mp4|webm|mov
friends/<userId>/story-videos/YYYY-MM/<uuid>.mp4|webm|mov
```

These sibling prefixes cannot pass the existing post image-prefix validation. Saving new or descriptor-changed videos verifies key scope/extension, existence, nonzero size, size cap, stored MIME and a bounded 64 KiB container plausibility check. MOV requires a structurally valid `ftyp` with major brand `qt  `, optionally preceded by `free`/`skip`/`wide` padding; older QuickTime files without this header are not accepted. HEIF/AVIF conflicting brands are rejected, and MP4 remains distinct. This check does not establish codec validity or sanitize video. Unchanged attached descriptors avoid redundant storage reads. Newly attached photos also require nonzero allowed-image HEAD metadata; existing/shared moment photos retain compatibility.

Removed videos and soft-deleted post media remain in storage deliberately: references may be shared. There is no new reference-count/orphan cleanup job, so failed uploads and removed files can consume storage until an explicitly designed maintenance process is introduced. Existing photo cleanup behavior is not redesigned here.

## Storage and deployment checks

Production uploads go directly to private S3 using a fresh signed URL immediately before each PUT; API Authorization is never forwarded to storage. Uploads are sequential, show progress and reuse successful PUTs if saving is retried. Failed PUT retries obtain fresh URLs. The upload/save sequence stays bound to its original mounted session; a session switch or unmount prevents later signing, saving and cache/toast updates (an already in-flight storage PUT may finish as an orphan). Upload signature TTL remains 120 seconds; download/cache behavior is unchanged. The SDK is configured not to sign an empty-body CRC32 for a nonempty browser upload; declared Content-Type and Content-Length are signed. These header checks do not verify actual file contents.

The required storage prefix API uses S3 Range and bounded streaming, stopping/destroying the stream at the cap even if a provider ignores Range. It must not fall back to reading the entire video. The development-only memory adapter implements GET/HEAD byte ranges (206/416) and the higher raw-body cap exclusively on dedicated post-video keys. This adapter is not production authorization evidence.

Before deploying, operators must verify actual private-bucket/IAM policy permits the new prefixes, CORS allows the application origin and needed PUT/GET/HEAD headers (including Content-Type and Range as applicable), and CDN/CSP permits media from the storage origin and `blob:` previews (`media-src`, plus appropriate `img-src`/`connect-src`). Existing API JSON 256 KiB and Caddy body caps do not need to increase: production media does not pass through those bodies. No live bucket/CDN configuration is changed by this feature.

Existing ACL checks still run before URLs are returned. Already-issued signed URLs cannot be instantly revoked after block/unfriend/delete; their existing expiration/cache lifetime remains a privacy limitation.

Local mixed-media verification also exposed an existing couple Story realtime feedback loop: feed refresh → mark seen → broad `stories` invalidation → feed refresh. Seen acknowledgements now publish `story-unread`, mapped only to the unread badge query; post/comment changes retain broad `stories` invalidation. Cross-tab badges remain synchronized without repeatedly loading the feed or weakening API rate limits. Deploy the matching backend/frontend domain lists together; older clients ignore the unfamiliar hint and retain polling/reconnect reconciliation.

## Verification

For MOV-specific automated evidence and the outstanding real-iPhone H.264/HEVC device matrix, see [MOV compatibility and verification](mov-compatibility.md).

```
npm --prefix backend run typecheck
npm --prefix backend run build
npm --prefix backend run test:media
npm --prefix frontend run build
npm --prefix frontend run test:media
```

Storage/signing tests are offline with synthetic credentials, not live AWS tests. Service unit fixtures validate container headers, not playable codecs. The separate browser suite uses real encoded media and local mocked providers/Mongo only:

```
node frontend/tests/post-media/browser.mjs
```

Read `scripts/browser/README.md` and start the guarded owned API4002/UI5175 fixtures before browser execution; the suite itself does not manage processes. Run it sequentially, not alongside API smoke lifecycle/performance runs. Review its screenshots/result JSON and stop only the owned API afterwards. Desktop mobile emulation does not establish physical-phone/native-picker, production CORS/CSP, HTTPS PWA or live S3 behavior.

Local verification on 2026-11-15: backend build/typecheck, frontend production build, 22 media service/model/route cases, 10 storage cases, frontend preparation/upload/player/composer regressions and existing realtime/mentions/session tests passed. The final browser run passed all 12 functional checkpoints with `errors: []`, including genuine encoded WebM playback, missing-MIME image decode, malformed-file feedback, privacy-mask pause/draft restoration, recipient live updates, reload/detail/Range and an idle couple feed without repeated seen requests. Earlier browser artifacts failed the HTTP audit with 429s before the seen feedback loop was corrected; they are not clean passes. This is WebM playback evidence, not MP4 codec or physical-device evidence.
