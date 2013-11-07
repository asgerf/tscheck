module A {
	export interface X { a: number }
}

module A.B {
	interface X { ab: number; }
}

module A.B {
	// X should point to A.X, because A.B.X is local to other module block
	export var x : X = { a: 5 }; 
}

