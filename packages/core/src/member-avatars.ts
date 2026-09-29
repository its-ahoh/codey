export const avatarShapes = ['circle', 'square', 'triangle', 'capsule'] as const;
export const avatarColors = ['#50D5A2', '#65AEF5', '#AC88EE', '#F080AB', '#F5A05F', '#EAC64F', '#4DCCD5', '#A5CE60', '#C195EC', '#DBA071'] as const;
// Preserve each saved avatar's color family when upgrading the original palette.
export const legacyAvatarColors: Readonly<Record<string, typeof avatarColors[number]>> = {
  '#8CCDB5': avatarColors[0], '#92B9E5': avatarColors[1],
  '#B5A2D8': avatarColors[2], '#E4A8BA': avatarColors[3],
  '#E9B587': avatarColors[4], '#D8C77F': avatarColors[5],
  '#8FC7CE': avatarColors[6], '#B8C994': avatarColors[7],
  '#C4B5D8': avatarColors[8], '#D4B49C': avatarColors[9],
};
export interface MemberAvatar { shape: typeof avatarShapes[number]; color: string; }
