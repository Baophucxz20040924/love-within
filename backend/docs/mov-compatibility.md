# MOV compatibility and verification

Couple Stories and Friends posts accept modern QuickTime MOV files with a structurally valid `ftyp` box whose major brand is `qt  ` (two trailing spaces). The bounded header check permits `free`, `skip`, and `wide` padding before `ftyp`; legacy QuickTime files without this header are not accepted. The MIME type is `video/quicktime`, distinct from MP4. Each post allows at most one video of up to 50 MiB, within the combined limit of ten attachments.

The browser must decode a real first frame before upload. The original video bytes are uploaded without transcoding. Successful playback on another device depends on its browser, operating system and the video's codec; MOV container acceptance does not guarantee H.264 or HEVC playback.

## Device verification still required

No real iPhone MOV fixture was supplied. Before claiming iPhone compatibility, test actual iPhone-recorded H.264 and HEVC MOV files separately across the intended sender and viewer devices and browsers. For each combination, record device/OS, browser, codec, first-frame preparation, upload, and playback after viewing and reload, including any failures. Do not infer this matrix from file headers or mocked video elements.

Retain the existing real WebM browser regression when running media checks; it establishes WebM behavior only, not MOV playback. Synthetic MOV header tests verify bounded classification and storage validation, not playable media. No ffmpeg/ffprobe or Docker daemon was available for this work.

## Automated checks (2026-11-17)

Backend media tests passed 23 model/service/route cases plus 10 storage cases. Frontend preparation/upload regressions, 6 native-player privacy/lifecycle cases and 36 composer session-safety cases passed. The backend build/typecheck and frontend production build passed. These are local automated checks; no new browser or physical iPhone playback run was performed for MOV.
