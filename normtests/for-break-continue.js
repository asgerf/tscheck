function f() {
	var foo = ['foo','bar','faz',null,'far'];
	var x = '';
	for (var i=0; i<foo.length; i++) {
		if (!foo[i])
			break;
		if (foo[i][0] === 'b')
			continue;
		x += foo[i];
	}
	console.log(x);
}
f();
