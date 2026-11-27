#!/usr/bin/with-contenv bash
set -Eeuo pipefail

# LinuxServer runs custom init scripts after generating this file and before
# starting Nginx. Remove the generated site if the rule cannot be installed.
config=/etc/nginx/sites-available/default
staged=
trap 'rm -f -- "$config" "$staged"' ERR

gateway_ip=${WORKSTATION_PROVIDER_IP:-}
if [[ ! $gateway_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
   [[ $(grep -cx 'server {' "$config") != 2 ]]; then
  echo 'Could not install the Workstation Selkies access rule' >&2
  false
fi

staged=$(mktemp "$config.XXXXXX")
{
  printf 'geo $workstation_gateway {\n  default 0;\n  %s 1;\n}\n' "$gateway_ip"
  cat <<'NGINX'
map "$workstation_gateway:$uri" $workstation_selkies_direct {
  default 0;
  ~^0:/browser/api/(tokens|websockets)(/|$) 1;
}
NGINX
  # Apply the source check to both the HTTP and TLS listeners.
  sed '/^server {$/a\  if ($workstation_selkies_direct) { return 403 "Gateway required"; }' "$config"
} >"$staged"
mv -- "$staged" "$config"
nginx -t
