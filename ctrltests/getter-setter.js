var foo = {
	get x() { return 5; },
	set x(v) { console.log(v) }
}

foo.x = foo.x;
