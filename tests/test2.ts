module A {
    export function h() {
        return "foo";
    }
    export var x = 5;
    
    export class Foo {
        constructor(public x: number) {}
    }
    
    export interface Private {
        y: number;
    }
    
    export function g(): Private {
        return {y: 5}
    }
}
