// Deliberately empty preload for windows that show untrusted documents (the
// exported report). Electron child windows inherit the opener's preload, which
// would expose the desktop bridge and tokens; overriding it with this file
// guarantees they get nothing.
export {};
