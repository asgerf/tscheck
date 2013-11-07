interface I<T> {
	x: T;
}
interface I<G> {
	foo<T>(y:T): G;
}
