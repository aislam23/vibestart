import type { UserDto } from '@vibestart/contracts'

import { PageContainer, PageHeader } from '@/components/PageLayout'
import { AppearancePanel } from '@/features/settings'
import { AccountSummary } from './AccountSummary'
import { ProfilePanel } from './ProfilePanel'

export function UserHome({ user }: { user: UserDto }) {
  return (
    <PageContainer>
      <PageHeader
        description="Review your account status and continue managing your workspace."
        title={`Welcome, ${user.displayName ?? user.email}`}
      />
      <AccountSummary user={user} />
    </PageContainer>
  )
}

export function UserProfile({ user }: { user: UserDto }) {
  return (
    <PageContainer>
      <div className="grid w-full max-w-2xl gap-6">
        <PageHeader
          description="Keep the identity shown across your workspace current."
          title="Profile"
        />
        <ProfilePanel user={user} />
      </div>
    </PageContainer>
  )
}

export function UserSettings() {
  return (
    <PageContainer>
      <PageHeader
        description="Choose how the workspace looks."
        title="Settings"
      />
      <div className="grid w-full max-w-xl gap-6">
        <AppearancePanel />
      </div>
    </PageContainer>
  )
}
