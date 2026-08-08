// Placeholder until the repository has a real remote (see the root README / T8, which pushes it
// to GitHub) - replace with the actual `https://github.com/<owner>/<repo>` URL once it exists.
export const TEMPLATE_ACTION = {
  href: 'https://github.com/your-org/vibestart',
  label: 'View the template on GitHub',
} as const

export function getSecondaryAction(publicWebappUrl?: string) {
  const webappUrl = publicWebappUrl?.trim()

  return webappUrl
    ? { href: webappUrl, label: 'Open the web app' }
    : { href: '#process', label: 'See how it works' }
}
