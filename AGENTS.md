# Privacy boundary

The real ComfyUI user directory is strictly forbidden. Do not read, list,
search, inspect, open, copy, summarize, modify, or delete anything under:

`/i/Programming/PythonDev/Python310/ComfyUI-New/user/`

This prohibition includes filenames, directory entries, file metadata, prompt
contents, workflows, settings, backups, wildcard files, and every other nested
path. Do not run commands whose scope could traverse or reveal this directory.

For development and tests, use only synthetic fixtures in temporary directories
outside the real ComfyUI user directory. Never point tests, scripts, dev servers,
or storage backends at the real user directory.
