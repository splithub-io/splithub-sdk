import { splithubMiddleware } from '@splithub/next';
import splithub from './splithub.config';

// Sets the visitor cookie, forwards it to Server Components and serves
// redirect experiments with an invisible rewrite.
export default splithubMiddleware(splithub);

export const config = {
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
