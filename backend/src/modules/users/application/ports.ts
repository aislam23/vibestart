export type ProfileWriter = {
  updateProfile(userId: string, displayName: string | null): Promise<{ displayName: string | null }>
}
