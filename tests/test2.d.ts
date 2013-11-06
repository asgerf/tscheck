declare module A {
    function h(): string;
    var x: number;
    class Foo {
        public x: number;
        constructor(x: number);
    }
    interface Private {
        y: number;
    }
    function g(): Private;
}

