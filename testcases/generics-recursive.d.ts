interface A<T> {
	car: T;
	cdr?: A<T>;
}
declare var good : A<string>;
declare var bad : A<string>;
