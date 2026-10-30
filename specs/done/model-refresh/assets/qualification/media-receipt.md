# Bounded read-only media qualification

Initial read-only qualification; later live evidence is recorded below. Metadata is from [the catalog receipt](../catalog-receipt.json) (retrieved 2026-09-27); documentation checked 2026-09-28 UTC.

## CLI request behavior

Agent src/cli/model.ts parseArgs starts only `{help:false}`: absent --duration, --aspect, --resolution and --fps stay undefined. runVideoPath passes these through unchanged. --resolution requires WxH, not 720p. --image reads a local file into Uint8Array. Language image models use runLanguageImagePath/generateText and do not forward --size or --aspect. CLI exposes no audio setting. Therefore provider-default resolution/audio cannot be inferred from CLI code.

Installed @ai-sdk/gateway/src/gateway-video-model.ts omits undefined parameters, sends model in ai-model-id, and serializes file bytes to base64 (does not upload them to a URL). Provider polling is handled by gateway/SDK; the CLI writes returned video bytes. Not a live provider success receipt.

## Representative metadata estimates (not reservations or exact bills)

- Gemini stable image: catalog default/1K cost is $0.067/image (512: .045; 2K: .101; 4K: .151). Text input/output adds token cost. Default image-size record supports this representative number even though CLI does not set size.
- Grok Imagine Video 1.5: .08/s at 480p, .14/s at 720p, .25/s at 1080p. Representative explicit `--resolution 1280x720 --aspect 16:9 --duration 5`: .70 video cost. No verified default resolution.
- Veo 3.1: .20/s at 720p/1080p without audio, .40 with audio; 4K .40 silent/.60 audio. A representative 720p 8s clip costs 1.60 silent or 3.20 with audio. CLI cannot force the audio branch today, and documentation page does not state default. Do not promote .20 as verified default request cost.
- Seedance 2.5: catalog 10.7 USD/million tokens at 480p/720p without video input; 11.7 at 1080p; video-input discounted rates 6.4/7.0. BytePlus estimated tokens formula=(input-video duration+output duration)*width*height*fps/1024, with minimum token floors. Representative text-only 1280x720, 24 fps, 5s  => 108000 tokens => 1.1556 USD (~.23112/s). This is arithmetic from specified settings, NOT confirmed CLI/provider defaults or a measured bill. Need model-specific floor/default confirmation before claiming more precision.

## Compatibility finding

Vercel Seedance 2.5 documentation says image URLs only and recommends hosting local files first. Current CLI always turns --image into bytes/base64. The later bounded live probe succeeded with local PNG bytes (3,636,498 video bytes, 4 seconds, 1280x720), so the existing image-to-video input path works through this gateway despite the documentation restriction. Do not silently add an upload service. CLI has no reference-video or audio inputs; those are not implied by a model target upgrade.

Sources:
- https://vercel.com/ai-gateway/models/seedance-2.5 (model id, dimensions, 4-30s, URL-only images, polling defaults 3s/5min)
- https://vercel.com/ai-gateway/models/veo-3.1-generate-001
- https://vercel.com/ai-gateway/models/grok-imagine-video-1.5
- https://docs.byteplus.com/en/docs/ModelArk/1544106 (search-index formula/floors; rendered page hides full table)
- https://docs.byteplus.com/docs/ModelArk/1099320 (indexed formula)
- local catalog-receipt.json (exact price records)

## Reproduction

bun /tmp/model-refresh-gateway-qualification/probe.ts
bun /tmp/model-refresh-gateway-qualification/routing-probe.ts

baseline-data.ts and baseline-routing.json were read from Duet git HEAD, avoiding ongoing contract edits. Probe request inspection/application code is imported from live workspace; catalog is frozen. routing-probe uses installed npm 0.3.26 binary modules, with a fixture tier over the frozen routing table.
