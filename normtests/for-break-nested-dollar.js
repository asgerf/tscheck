function foo() {
	$1: for (var i=0; i<10; i++) {
		foo: for (var j=0; j<10; j++) {
			if (j == 6)
				continue foo;
			if (j + i === 16)
				break $1;
		}
	}
	return i + j;
}
console.log(foo());
