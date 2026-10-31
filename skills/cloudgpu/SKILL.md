---
name: cloudgpu
description: Rent and use a cloud GPU on CloudGPU (cloudgpu.app) through the `cloudgpu` MCP tools. Use when the user wants to rent a GPU, run a training, fine-tuning, inference or ComfyUI job on a cloud GPU, or mentions CloudGPU or cloudgpu.app, and the `cloudgpu` MCP tools are available.
---

# CloudGPU

Follow these steps whenever you rent or use a GPU on CloudGPU (cloudgpu.app) through the `cloudgpu` MCP tools.

## Before renting

1. Call `get_account` and `list_gpus`. Pick a GPU with enough VRAM for the job, and don't rent more GPU than the job needs. As a rough guide, LoRA on a 7–8B model fits in 24 GB, and a full fine-tune of the same model needs 80 GB or more.
2. Call `estimate_cost` with a realistic number of hours.
3. Show the user a short quote before you rent anything:
   - the GPU and how many,
   - the price per hour,
   - the estimated hours and cost,
   - the budget and time limit you will set,
   - their balance after the job.
4. Rent only after the user says yes. Pass `user_confirmed=true` only in that case.

## Renting

- Always set `max_spend_usd` and `max_hours`. CloudGPU's servers destroy the instance when either is reached, even if you have disconnected.
- Keep `idle_minutes` on (default 60). Raise it if setup will take long, because installing packages and downloading models leave the GPU idle.
- Call `get_status` at intervals, not in a tight loop, until the instance is `running`.
- `failed` instances are not charged. Tell the user, then offer another GPU.

## Working on the instance

- Put code and data on the instance with `upload`. Do not upload credentials.
- Use `run_command` for short steps. For training, long installs or big downloads, use `background=true` and follow progress with `tail_logs`.
- Instances come with Python and CUDA, but not always PyTorch. Check first: `nvidia-smi -L` and `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`.
- If PyTorch is missing, plain `pip install torch` installs a current CUDA build. It is a few GB, so run it with `background=true`. Index URLs for older CUDA versions (for example `.../whl/cu124`) may have no wheel for the machine's Python, which can be very new. Only use them if the project needs that CUDA version, and then create an environment with an older Python first (`conda create -y -n work python=3.12`, then `conda activate work && ...` in each command).
- If `nvidia-smi` shows no GPU once the instance is running, stop and tell the user. CloudGPU detects such machines and shuts them down automatically.
- **Do not** change the root password, edit the SSH configuration, change the firewall, or stop the platform's monitoring agent (`cgpu-*` processes). The platform must keep its access to the instance; if that access is lost, the platform shuts the instance down. The MCP server refuses such commands.
- Never use the GPU for cryptocurrency mining or anything the [acceptable use policy](https://cloudgpu.app/aup) forbids. Instances that do so are shut down.

## Finishing (always)

1. Download every result: model weights, adapters, checkpoints, logs, metrics. Destroying an instance erases its disk, and CloudGPU has no persistent storage.
2. Call `stop_instance`.
3. Tell the user what ran, where the results are on their computer, and the final cost from `stop_instance`.

If anything goes wrong mid-way, do not leave the instance running. Download whatever exists, stop the instance, then explain what happened.

## Only need a model, not a GPU?

The same API key works for CloudGPU's model API at `https://cloudgpu.app/v1`. Call `list_models` to see the models. If you only need inference on a hosted model, use the API instead of renting a GPU.

## If the MCP server is not installed

If no `cloudgpu` tools are available, the MCP server needs to be set up first:

- Command: `npx -y cloudgpu-mcp`
- Environment variable: `CLOUDGPU_API_KEY`, with a key created at https://cloudgpu.app.
- Never paste the key into the chat or into files in the project. Ask the user to put it in their MCP client's configuration or environment themselves.

See the [README](https://github.com/mrhy7176/cloudgpu-mcp#install) for per-client setup.
