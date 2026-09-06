import { useCallback, useEffect, useState } from 'react'
import type { BuiltinMember, MemberAvatar } from '../../../packages/core/src/member-avatars'
export function useBuiltinAvatars() {
  const [avatars, setAvatars] = useState<Partial<Record<BuiltinMember, MemberAvatar>>>({})
  const refresh = useCallback(() => {
    void window.codey.builtinAvatars.get().then(r => { if (r.ok) setAvatars(r.data) }).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    window.addEventListener('codey:workers-changed', refresh)
    return () => window.removeEventListener('codey:workers-changed', refresh)
  }, [refresh])
  return avatars
}
