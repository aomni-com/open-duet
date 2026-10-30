#!/bin/bash

set -euo pipefail
umask 077

state_dir=/home/exedev/.duet/desktop
auth_file="$state_dir/kasm-auth.json"
password_file=/home/exedev/.kasmpasswd

mkdir -p "$state_dir"
if [[ ! -s "$auth_file" ]]; then
  password="$(openssl rand -base64 32)"
  jq -n --arg username duet --arg password "$password" \
    '{username: $username, password: $password}' > "$auth_file"
fi

username="$(jq -er '.username | select(type == "string" and length > 0)' "$auth_file")"
password="$(jq -er '.password | select(type == "string" and length >= 6)' "$auth_file")"
rm -f "$password_file"
printf '%s\n%s\n' "$password" "$password" | \
  HOME=/home/exedev /usr/bin/kasmvncpasswd -u "$username" -w >/dev/null
chmod 600 "$auth_file" "$password_file"
