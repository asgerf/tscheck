interface Foo<T> {
	x: T;
}
declare enum E {
	X, Y
}
declare var good : Foo<E>;
declare var bad : Foo<E>;

