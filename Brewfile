# eal development dependencies
# Run: brew bundle

# Local speech-to-text — wired into the agent worker as EAL_STT_PROVIDER=whisper-local
# (see packages/cli/src/commands/stt-whisper.ts). The binary is /opt/homebrew/bin/whisper-cli.
brew "whisper-cpp"

# Isolated Python app installer — used below to provision piper-tts.
brew "pipx"

# Local text-to-speech — wired into the agent worker as EAL_TTS_PROVIDER=piper
# (see packages/cli/src/commands/tts-piper.ts). Piper has no Homebrew formula
# and the legacy GitHub binary release ships broken on macOS (missing
# dylibs). The maintained fork ships as a Python wheel; pipx gives us the
# `piper` binary on PATH without polluting any system Python. After
# `brew bundle`:
#   pipx ensurepath && pipx install piper-tts
# That puts the binary at ~/.local/bin/piper.
