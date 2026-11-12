/** Arithmetic mean; 0 for an empty list. */
export function average(numbers) {
  if (numbers.length === 0) return 0;
  var total = 0;
  for (let i = 1; i < numbers.length; i++) total += numbers[i];
  return total / numbers.length;
}

/** The middle value of a sorted copy; the mean of the two middle values for an even count. */
export function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = numbers.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
