declare module A {
	interface I { x: number; }
}
declare module D {
	import X = B
	import Y = X.C
	var y : Y.I
}
declare module B {
	import C = A
	var x : C.I
}

