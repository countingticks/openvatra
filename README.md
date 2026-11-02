<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/lockup-horizontal-dark.svg" />
    <img src=".github/assets/lockup-horizontal-light.svg" alt="OpenVatra" width="372" />
  </picture>
</h1>

**Your AI's home hearth.** Local models, chat, code and automations in one open-source desktop app.

_Vatra_ is Romanian for _hearth_: the fire at the center of a home. OpenVatra keeps your AI at home too —
models run on your own PC, and your conversations never leave it.

> **Status: early development.** There is nothing to install yet. Follow the repository for the first release.

## What it will do

- **Chat** with local language models, with optional web search and answers grounded in your own documents
- **Code** with a local AI coding agent working on your projects
- **Automate** recurring tasks with a local AI assistant (later)
- **Set itself up**: choose where models live, detect your hardware, and download models that fit it

## Planned requirements

- Windows 10 or 11 (64-bit)
- An NVIDIA GPU with 8 GB+ of VRAM is recommended; 12 GB+ for the larger models
- 16 GB+ RAM (32 GB recommended) and free disk space for models (10–25 GB each)

## Privacy

Everything runs locally. The only things that reach the internet are web searches you enable and model downloads.

## Built on

OpenVatra brings together excellent open-source projects:
[llama.cpp](https://github.com/ggml-org/llama.cpp),
[llama-swap](https://github.com/mostlygeek/llama-swap),
[Ollama](https://github.com/ollama/ollama),
[Open WebUI](https://github.com/open-webui/open-webui),
[OpenCode](https://github.com/anomalyco/opencode).

## License

[MIT](LICENSE) © 2026 countingticks. Third-party components keep their own licenses.

The OpenVatra name, logo and ember mascot are not covered by the MIT license. Please don't use them to represent
other projects or forks; you're welcome to use them to refer to OpenVatra itself.
