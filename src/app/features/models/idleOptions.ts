// The segmented control works with strings; each option carries the minutes it stands for (null = never).
export const idleOptions = [
  { value: '5', label: '5 min', minutes: 5 },
  { value: '15', label: '15 min', minutes: 15 },
  { value: '30', label: '30 min', minutes: 30 },
  { value: '60', label: '1 hour', minutes: 60 },
  { value: 'never', label: 'Never', minutes: null }
] as const
