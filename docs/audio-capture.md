# Capturing audio on each platform

Microphone capture works the same way everywhere. System audio, which is the
interesting case, does not. This page says exactly what works where, including
the parts that need a piece of software earshot cannot install for you.

earshot never opens an audio device itself. It runs ffmpeg with the right flags
for your platform and reads 16 kHz mono PCM off its stdout, so anything ffmpeg
can record from, earshot can transcribe.

## Summary

| | microphone | system audio (loopback) |
|---|---|---|
| **Linux** (PulseAudio or PipeWire) | works out of the box | works out of the box |
| **Windows** 10 and 11 | works out of the box | needs a virtual audio device |
| **macOS** 12 and later | works after granting permission | needs a virtual audio device |

The reason for the split is that PulseAudio exposes a `.monitor` source for
every output sink, so recording what the speakers are playing is a first-class
operation. Windows has WASAPI loopback but ffmpeg's DirectShow input cannot
reach it, and macOS has no system audio capture API available to an ordinary
process at all. On both, a virtual output device is the standard answer.

---

## Linux

Nothing to install beyond ffmpeg. PulseAudio resolves two special names at
connect time, and pipewire-pulse understands them too:

```bash
earshot                    # -f pulse -i @DEFAULT_SOURCE@
earshot --source system    # -f pulse -i @DEFAULT_MONITOR@
```

To pick a specific source:

```bash
pactl list short sources
earshot --source system --device alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
```

`earshot --list-devices` runs that `pactl` command for you.

On a pure ALSA system without PulseAudio there is no monitor source, and
loopback needs an `.asoundrc` `dsnoop`/`dmix` arrangement that is outside what
this tool sets up.

## Windows

**Microphone** works immediately:

```powershell
earshot
```

ffmpeg addresses DirectShow devices by their exact name, so there is no
"default". earshot lists the devices and picks the first non-loopback input,
and prints which one it chose. To pick your own:

```powershell
earshot --list-devices
earshot --device "Microphone (Realtek(R) Audio)"
```

**System audio** needs a device that presents the output as an input. Two
options, in order of how likely they are to work:

1. **Stereo Mix.** Some Realtek drivers ship it, disabled by default. Sound
   settings, Recording tab, right click, Show Disabled Devices, then enable
   *Stereo Mix*. Free, no install, but plenty of machines simply do not have it.
2. **[VB-CABLE](https://vb-audio.com/Cable/)** (donationware). Installs a
   virtual cable: set it as the playback device for what you want to capture,
   then record from `CABLE Output`. Set it up as a *Listen to this device* pass
   through, or use VB-Audio's Voicemeeter, if you also want to hear the audio
   while it is being captured.

Once one of those exists:

```powershell
earshot --source system
```

earshot looks for a device whose name matches Stereo Mix, CABLE Output, VB-Audio
or similar. If it finds none it stops with an error rather than quietly
recording your microphone instead.

Latency note: DirectShow's default buffering adds a noticeable delay, so earshot
passes `-audio_buffer_size 50`. On a loaded machine that can produce dropped
sample warnings from ffmpeg; raise it by editing the value if the transcript
starts losing words.

## macOS

**Microphone** works, but the first run triggers the system permission prompt.
The prompt is attributed to the app running ffmpeg, which is your terminal, so
grant Terminal (or iTerm, or your IDE) access under System Settings, Privacy and
Security, Microphone. Without it ffmpeg captures silence and never says why.

```bash
earshot --list-devices
earshot                          # first non-loopback audio device
earshot --device 0               # AVFoundation addresses devices by index
```

**System audio** needs a virtual output device. The usual choice is
**[BlackHole](https://github.com/ExistentialAudio/BlackHole)** (MIT licensed,
installs a 2ch virtual device):

```bash
brew install blackhole-2ch
```

Then either set BlackHole as the system output, which means you stop hearing the
audio, or build a Multi-Output Device in Audio MIDI Setup containing both your
speakers and BlackHole, which lets you hear it and capture it at once. After
that:

```bash
earshot --source system
```

Soundflower and Loopback (the commercial one from Rogue Amoeba) work the same
way and are recognised by name.

---

## Transcribing a file

No device involved, and no platform differences. ffmpeg decodes whatever it
supports:

```bash
earshot --source file --file interview.m4a
```

Raw 16 kHz mono PCM (`.pcm`, `.raw`) is read directly without ffmpeg, which is
what the tests use.

## When the transcript is empty

In order of how often it is the cause:

1. **The wrong device.** `earshot --list-devices`, then pass `--device`
   explicitly. On Windows a mistyped device name is a hard ffmpeg error; on
   macOS a permission problem is silence.
2. **The threshold.** earshot only sends audio to the model when the level is
   above `--threshold` (default 600 RMS on the Int16 scale). A quiet
   microphone or a distant speaker needs a lower number. Try `--threshold 250`.
   A noisy room needs a higher one.
3. **The language.** The `.en` models are English only and produce nonsense on
   other languages. Use a multilingual model and set the language:
   `--model small --language pl`.
4. **The model is too small.** `tiny.en` is fast and wrong often. `small.en` is
   the point where most people stop complaining.
