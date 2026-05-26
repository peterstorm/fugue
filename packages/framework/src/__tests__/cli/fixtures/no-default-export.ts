// Fixture: a module that compiles but has no default export. The CLI must
// report { kind: "no-default-export" }.

export const notDefault = { dag: "this is not a registration" };
