# Video Delta Swap Lab

A dependency-free browser test bench for feeding delta frames from three independently encoded resolutions into WebCodecs `VideoDecoder` instances. AV1, H.264/AVC, and VP9 are available from the codec selector.

## Run it

Serve the directory from localhost (camera access requires a secure context):

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a current Chromium-based browser and allow camera access.

## Strategies

- **Continuous delta swap** keeps one decoder configured and sends it the next chunk from the newly selected encoder without a keyframe or reset.
- **Reconfigure + delta** applies the selected encoder's decoder configuration, then submits its next delta chunk.
- **Keyframe handoff** resets and reconfigures one decoder, requesting a keyframe on the selected encoder.
- **Transcoded bridge** remembers the latest decoder output, scales and re-encodes it as a keyframe on the target encoder, then admits only target chunks produced after that bridge.
- **Isolated decoders** continuously primes one decoder per resolution and switches only the displayed output.

All three encoders for the selected codec run at the same time. The output monitor includes a lightweight PSNR comparison against the corresponding camera frame to help flag obvious corruption; visual inspection remains the definitive check.
