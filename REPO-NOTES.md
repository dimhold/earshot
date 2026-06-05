# Repository notes

Settings for the GitHub repository itself. Not part of the code.

## Description (one line)

> A live transcript of whatever your machine is hearing, produced entirely on your machine. No cloud, no meeting bot.

## Topics

```
transcription
speech-to-text
whisper
faster-whisper
local-first
privacy
offline
audio-capture
loopback
live-transcript
typescript
nodejs
ffmpeg
cli
self-hosted
```

## Website

Leave empty, or point at the blog post about the build.

## Settings

- **Issues:** on. Platform-specific audio capture is exactly the thing people
  will report, and those reports are the roadmap.
- **Discussions:** off for now. Turn it on if issues start filling with
  questions rather than bugs.
- **Wiki, Projects:** off. The README and `docs/` are the documentation.
- **Releases:** tag `v0.1.0` when the first live capture has been confirmed on
  all three platforms.

## Social preview image

`assets/hero.png` works as-is.

## Before making it public

- [ ] Confirm the name. `earshot` is unclaimed on npm as of writing; check again
      before publishing if there is any intention of releasing a package.
- [ ] Run one session with the network disabled, to back the privacy claim in
      the README with something observed rather than argued.
- [ ] Confirm live capture on at least one platform besides the development
      machine, and correct the support table if anything is wrong.

## Open questions

- Should the model download move to first run instead of a separate command?
  It is friendlier, and it makes the "no network calls" claim harder to state
  cleanly. Currently kept as an explicit step for that reason.
- Word-level streaming, instead of utterance-level lines, would change how the
  tool feels more than any accuracy improvement would. It also means a different
  segmentation strategy and probably a different engine binding.
