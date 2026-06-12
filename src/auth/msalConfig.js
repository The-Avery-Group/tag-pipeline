import { PublicClientApplication, LogLevel } from '@azure/msal-browser'

const appUrl = import.meta.env.VITE_APP_BASE_URL || window.location.origin

export const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID}`,
    redirectUri: appUrl,
    postLogoutRedirectUri: appUrl,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return
        if (import.meta.env.DEV) console.log(`[MSAL ${level}] ${message}`)
      },
      logLevel: LogLevel.Warning,
    },
  },
}

export const loginRequest = {
  scopes: ['User.Read', 'Files.ReadWrite', 'Sites.ReadWrite.All'],
}

export const graphConfig = {
  graphMeEndpoint: 'https://graph.microsoft.com/v1.0/me',
  graphFilesEndpoint: 'https://graph.microsoft.com/v1.0/me/drive/items',
}

export const msalInstance = new PublicClientApplication(msalConfig)
