import { installCollaboration } from '../src/collaboration/index.js'
import type { DshCollaborationContext } from '../src/collaboration/dsh-runner.js'

/** Host-owned composition fixture; never called from the bundle's normal apply(). */
export function composeHuiyiCollaboration(ctx: DshCollaborationContext) {
  return installCollaboration(ctx)
}
