#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/outside-the-git-worktree" >&2
  exit 2
fi
OUT="$1"
mkdir -p "$OUT"
chmod 700 "$OUT"

nvidia-smi > "$OUT/nvidia-smi.txt"
nvidia-smi -q -d PERFORMANCE,CLOCK,POWER,TEMPERATURE,PCI > "$OUT/nvidia-smi-detail.txt"
nvidia-smi --query-gpu=index,name,compute_cap,memory.total,memory.used,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,pci.bus_id --format=csv > "$OUT/gpu-summary.csv"
nvidia-smi pmon -c 5 > "$OUT/gpu-process-samples.txt"
nvidia-smi dmon -s pucm -d 1 -c 30 > "$OUT/gpu-device-samples.txt"
cat /etc/os-release > "$OUT/os-release.txt"
uname -a > "$OUT/uname.txt"
lscpu > "$OUT/lscpu.txt"
free -h > "$OUT/free.txt"
df -h /root/gpufree-data /root/gpufree-share > "$OUT/df-space.txt"
df -i /root/gpufree-data /root/gpufree-share > "$OUT/df-inodes.txt"
for name in cpu.max cpuset.cpus.effective io.stat memory.current memory.max memory.events memory.swap.current memory.swap.max; do
  file="/sys/fs/cgroup/$name"
  if [[ -r "$file" ]]; then cat "$file" > "$OUT/cgroup-${name//\//-}.txt"; fi
done
ss -ltnp > "$OUT/listeners.txt"
printf 'Collected at UTC: %s\n' "$(date -u +%FT%TZ)" > "$OUT/collection.txt"
