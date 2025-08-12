// Export all proto types
export type {
  // Main SDK Messages
  DriverInitRequest,
  DriverInitResponse,
  AutomationFrameworkInitRequest,
  AutomationFrameworkInitResponse,
  AutomationFrameworkStartRequest,
  AutomationFrameworkStartResponse,
  AutomationFrameworkStopRequest,
  AutomationFrameworkStopResponse,
  StartBinSessionRequest,
  StartBinSessionResponse,
  ConnectBinSessionRequest,
  ConnectBinSessionResponse,
  StopBinSessionRequest,
  StopBinSessionResponse,
  TestFrameworkEventRequest,
  TestFrameworkEventResponse,
  TestSessionEventRequest,
  TestSessionEventResponse,
  LogCreatedEventRequest,
  LogCreatedEventResponse,
  FetchDriverExecuteParamsEventRequest,
  FetchDriverExecuteParamsEventResponse,
  ExecutionContext,
  TestSessionEventRequest_AutomationSession as AutomationSession,
  LogCreatedEventRequest_LogEntry,
  FindNearestHubRequest,
  FindNearestHubResponse,
  TestOrchestrationRequest,
  TestOrchestrationResponse,
  TestOrchestration,
  RetryTestsOnFailure,
  AbortBuildOnFailure,
  EnqueueTestEventRequest,
  EnqueueTestEventResponse,
} from './generated/sdk-messages.js';

// Accessibility types
export type {
  Accessibility,
  AccessibilityConfigRequest,
  AccessibilityConfigResponse,
  AccessibilityResultRequest,
  AccessibilityResultResponse,
} from './generated/sdk-messages-accessibility.js';

// AI types
export type {
  AIBrowserExtensionRequest,
  AIBrowserExtensionResponse,
  AISelfHealGetRequest,
  AISelfHealGetResponse,
  AISelfHealStepRequest,
  AISelfHealStepResponse,
} from './generated/sdk-messages-ai.js';

// Observability types
export type {
  KeyMessage,
  Observability,
  ObservabilityConfigRequest,
  ObservabilityConfigResponse,
} from './generated/sdk-messages-observability.js';

// Percy types
export type {
  Percy,
} from './generated/sdk-messages-percy.js';

// TestHub types
export type {
  TestHub,
} from './generated/sdk-messages-testhub.js';

// gRPC Service Client and credentials
export { SDKClient } from './generated/sdk.js';
export { credentials as grpcCredentials, Channel as grpcChannel, type ChannelCredentials } from '@grpc/grpc-js';

// Export message constructors
import * as SdkMessages from './generated/sdk-messages.js';

// Create factory objects with create methods for backward compatibility
export const StartBinSessionRequestConstructor = {
  create: (init: Partial<SdkMessages.StartBinSessionRequest> = {}): SdkMessages.StartBinSessionRequest => {
    return {
      binSessionId: '',
      sdkLanguage: '',
      sdkVersion: '',
      pathProject: '',
      pathConfig: '',
      envVars: {},
      cliArgs: [],
      frameworks: [],
      frameworkVersions: {},
      language: '',
      languageVersion: '',
      testFramework: '',
      wdioConfig: '',
      ...init
    };
  }
};

export const StopBinSessionRequestConstructor = {
  create: (init: Partial<SdkMessages.StopBinSessionRequest> = {}): SdkMessages.StopBinSessionRequest => {
    return {
      binSessionId: '',
      exitCode: 0,
      exitSignal: '',
      exitReason: '',
      customMetadata: '',
      ...init
    };
  }
};

export const ConnectBinSessionRequestConstructor = {
  create: (init: Partial<SdkMessages.ConnectBinSessionRequest> = {}): SdkMessages.ConnectBinSessionRequest => {
    return {
      binSessionId: '',
      platformIndex: 0,
      ...init
    };
  }
};

export const TestFrameworkEventRequestConstructor = {
  create: (init: Partial<SdkMessages.TestFrameworkEventRequest> = {}): SdkMessages.TestFrameworkEventRequest => {
    return {
      binSessionId: '',
      platformIndex: 0,
      testFrameworkName: '',
      testFrameworkVersion: '',
      uuid: '',
      eventJson: new Uint8Array(),
      testFrameworkState: '',
      testHookState: '',
      startedAt: '',
      endedAt: '',
      executionContext: undefined,
      ...init
    };
  }
};

export const TestSessionEventRequestConstructor = {
  create: (init: Partial<SdkMessages.TestSessionEventRequest> = {}): SdkMessages.TestSessionEventRequest => {
    return {
      binSessionId: '',
      platformIndex: 0,
      testFrameworkName: '',
      testFrameworkVersion: '',
      testFrameworkState: '',
      testHookState: '',
      testUuid: '',
      automationSessions: [],
      executionContext: undefined,
      capabilities: new Uint8Array(),
      ...init
    };
  }
};

export const ExecutionContextConstructor = {
  create: (init: Partial<SdkMessages.ExecutionContext> = {}): SdkMessages.ExecutionContext => {
    return {
      threadId: '',
      processId: '',
      hash: '',
      ...init
    };
  }
};

export const LogCreatedEventRequestConstructor = {
  create: (init: Partial<SdkMessages.LogCreatedEventRequest> = {}): SdkMessages.LogCreatedEventRequest => {
    return {
      binSessionId: '',
      platformIndex: 0,
      logs: [],
      executionContext: undefined,
      ...init
    };
  }
};

export const LogCreatedEventRequest_LogEntryConstructor = {
  create: (init: Partial<SdkMessages.LogCreatedEventRequest_LogEntry> = {}): SdkMessages.LogCreatedEventRequest_LogEntry => {
    return {
      testFrameworkName: '',
      testFrameworkVersion: '',
      testFrameworkState: '',
      timestamp: '',
      uuid: '',
      kind: '',
      message: new Uint8Array(),
      level: '',
      fileName: '',
      fileSize: 0,
      filePath: '',
      ...init
    };
  }
};

export const AutomationSessionConstructor = {
  create: (init: Partial<SdkMessages.TestSessionEventRequest_AutomationSession> = {}): SdkMessages.TestSessionEventRequest_AutomationSession => {
    return {
      provider: '',
      frameworkName: '',
      frameworkVersion: '',
      frameworkSessionId: '',
      ref: '',
      hubUrl: '',
      ...init
    };
  }
};

export const DriverInitRequestConstructor = {
  create: (init: Partial<SdkMessages.DriverInitRequest> = {}): SdkMessages.DriverInitRequest => {
    return {
      binSessionId: '',
      platformIndex: 0,
      ref: '',
      userInputParams: new Uint8Array(),
      ...init
    };
  }
};

export const FetchDriverExecuteParamsEventRequestConstructor = {
  create: (init: Partial<SdkMessages.FetchDriverExecuteParamsEventRequest> = {}): SdkMessages.FetchDriverExecuteParamsEventRequest => {
    return {
      binSessionId: '',
      product: '',
      scriptName: '',
      ...init
    };
  }
};


