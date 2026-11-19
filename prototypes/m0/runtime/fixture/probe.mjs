import { appendFileSync } from 'node:fs'

export function apply() {
  if (process.env.M0_MOUNT_LOG) appendFileSync(process.env.M0_MOUNT_LOG, 'mounted\n')
}
