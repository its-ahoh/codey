export const avatarShapes = ['circle', 'square', 'triangle', 'capsule'] as const;
export const avatarColors = ['#8CCDB5', '#92B9E5', '#B5A2D8', '#E4A8BA', '#E9B587', '#D8C77F', '#8FC7CE', '#B8C994', '#C4B5D8', '#D4B49C'] as const;
export interface MemberAvatar { shape: typeof avatarShapes[number]; color: string; }
export type BuiltinMember = 'aide' | 'advisor';
export const builtinAvatarDefaults: Record<BuiltinMember, MemberAvatar> = {
  aide: { shape: 'circle', color: '#8CCDB5' },
  advisor: { shape: 'square', color: '#B5A2D8' },
};
export function isMemberAvatar(value: unknown): value is MemberAvatar {
  const avatar = value as MemberAvatar | undefined;
  return !!avatar && avatarShapes.includes(avatar.shape) && avatarColors.includes(avatar.color as typeof avatarColors[number]);
}
export function builtinAvatar(member: BuiltinMember, values?: Partial<Record<BuiltinMember, MemberAvatar>>): MemberAvatar {
  return isMemberAvatar(values?.[member]) ? { ...values![member]! } : { ...builtinAvatarDefaults[member] };
}
