declare module X {
	export interface I { x: number; }
}
declare module A {
	module B {
		export import Q = X;
	}
	// B.Q.I resolves to X.I
	// the type X.I is publicly visible, but type resolution goes through private module
	export var x : B.Q.I; 
}
