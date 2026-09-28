export interface ChatPreferences {
  sendOnEnter: boolean;
}

export const defaultPreferences = (): ChatPreferences => ({
  sendOnEnter: true
});
