export const avatarShapes = ['circle', 'square', 'triangle', 'capsule'] as const;
export const avatarColors = ['#8CCDB5', '#92B9E5', '#B5A2D8', '#E4A8BA', '#E9B587', '#D8C77F', '#8FC7CE', '#B8C994', '#C4B5D8', '#D4B49C'] as const;
export interface MemberAvatar { shape: typeof avatarShapes[number]; color: string; }
