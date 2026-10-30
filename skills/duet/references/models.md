# Models and media

Use `duet model` for a direct generation without starting an agent session.
Read `duet model --help` first; installed help owns available flags and syntax.
Authenticate and select the intended workspace through the
[installation workflow](installation.md) before spending Duet credits. Select it
with the advertised `duet workspace use <slug>` command; do not assume `duet model`
accepts the workspace flags of other command groups.

## Choose a model

For text, omit `--model` to use the selected workspace’s effective model choice.
If that choice is a compound router, direct generation uses its general route;
it does not call a classifier or advisor. An explicit compound choice follows
that same route. An explicit gateway model ID is sent unchanged and overrides
the default. Direct generation bills at upstream cost, including compound-backed
calls; selecting a compound does not claim an agent tier tariff.

```sh
duet model "Explain this paragraph briefly"
duet model --model <gateway-model-id> "Explain this paragraph briefly"
```

For an ordinary image or video, specify the output type and omit the model to
use Duet’s existing media default:

```sh
duet model --type image --out illustration.png "A simple botanical illustration"
duet model --type video --out clip.mp4 "A stationary camera watching a leaf fall"
```

Chat compounds choose text models; they do not choose image/video generators.
For a user-requested media model, supply its exact upstream ID. Discovery returns
the full upstream model list, including media outside Duet’s product catalog.
Upstream decides whether that model supports the operation. Listed speech,
transcription or other types do not add those operations to this CLI.

An image-producing language model still appears as `type: language`. Pass
`--type image` to request image files from its language operation. For editing,
use the advertised `--image` input with a model that accepts images. Verify the
actual output files; text mentioning an image is not a generated image. Native
models can use the advertised `--n` count control. For language-image models,
request the count in the prompt and check all returned files; a count request is
not proof that the provider returned exactly that many.

## Discover without starting a generation

Use the gateway’s authenticated `/v1/models` API when model metadata is needed.
With a human key, select the billing workspace with `x-duet-workspace`.
Keep credentials out of chat, command output and committed files. The CLI’s
capability lookup is a read; it is not another model approval list.

An MCP-only agent can use `list_models` with its workspace. Follow `nextCursor`
until null; optional `kind` filters the upstream type before paging. To find
language models producing images, use the full list and inspect output-modality
metadata rather than filtering only for native image models. Preserve a
requested ID; do not silently replace a rejected model with a default.

`generate_media` accepts existing Duet roles or exact raw IDs. Omit its model to
use the role matching `kind`. It returns one durable Drive ResourceLink, so read
or download that resource to verify the bytes. Model discovery requires service
access; generation additionally needs the file capabilities advertised by the
tool. Optional video duration/resolution controls can bound the requested output.

## Verify and recover

The CLI prints paths for generated media; inspect file existence, type and size.
For text, consume the command to its exit result. A failed SDK stream is an error,
not an empty successful completion. A completed artifact and settled billing are
separate facts; use the installed usage commands when accounting verification is
part of the task.

Native media uses an upfront $2 hold and settles at actual upstream cost. The
hold is not a final-price ceiling; a cheap model can still require the full hold.
Missing generation IDs or unavailable provider cost can prevent reconciliation.
Report that state rather than treating file output as proof of a settled charge.

For a bounded paid run, use `--max-retries 0` when installed help advertises it;
it disables SDK retries for text, native media and language-image generation.
If the installed version cannot advertise that control, upgrade through the
installation workflow before a task requiring no automatic paid retries. Recheck
help after upgrading; if the current release still lacks the control, report the
missing capability before generating.
Without that flag, existing SDK retry defaults apply. After an ambiguous failure,
inspect output and usage before retrying; an error or disconnected stream does
not prove the upstream generation never ran.
