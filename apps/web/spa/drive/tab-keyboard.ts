export function rovingTabIndexForKey(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (tabCount < 1) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (currentIndex + 1) % tabCount
    case 'ArrowLeft':
    case 'ArrowUp':
      return (currentIndex - 1 + tabCount) % tabCount
    case 'Home':
      return 0
    case 'End':
      return tabCount - 1
    default:
      return null
  }
}
