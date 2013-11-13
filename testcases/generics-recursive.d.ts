interface A<T> {
	car: T;
	cdr?: A<T>;
}
declare var x : A<string>;
