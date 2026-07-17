// Saves a fetched blob to disk via a temporary object URL and anchor click.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Delay revocation so the browser has started reading the blob first.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
