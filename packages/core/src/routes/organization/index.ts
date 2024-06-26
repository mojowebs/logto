import {
  type OrganizationWithFeatured,
  Organizations,
  featuredUserGuard,
  userWithOrganizationRolesGuard,
} from '@logto/schemas';
import { yes } from '@silverhand/essentials';
import { z } from 'zod';

import { EnvSet } from '#src/env-set/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import koaPagination from '#src/middleware/koa-pagination.js';
import koaQuotaGuard from '#src/middleware/koa-quota-guard.js';
import { userSearchKeys } from '#src/queries/user.js';
import SchemaRouter from '#src/utils/SchemaRouter.js';
import { parseSearchOptions } from '#src/utils/search.js';

import { type ManagementApiRouter, type RouterInitArgs } from '../types.js';

import applicationRoleRelationRoutes from './index.application-role-relations.js';
import emailDomainRoutes from './index.jit.email-domains.js';
import userRoleRelationRoutes from './index.user-role-relations.js';
import organizationInvitationRoutes from './invitations.js';
import organizationRoleRoutes from './roles.js';
import organizationScopeRoutes from './scopes.js';
import { errorHandler } from './utils.js';

export default function organizationRoutes<T extends ManagementApiRouter>(
  ...args: RouterInitArgs<T>
) {
  const [
    originalRouter,
    {
      queries: { organizations },
      libraries: { quota },
    },
  ] = args;

  const router = new SchemaRouter(Organizations, organizations, {
    middlewares: [koaQuotaGuard({ key: 'organizationsEnabled', quota, methods: ['POST', 'PUT'] })],
    errorHandler,
    searchFields: ['name'],
    disabled: { get: true },
    idLength: 12,
  });

  router.get(
    '/',
    koaPagination(),
    koaGuard({
      query: z.object({ q: z.string().optional(), showFeatured: z.string().optional() }),
      response: (
        Organizations.guard.merge(
          // For `showFeatured` query
          z
            .object({
              usersCount: z.number(),
              featuredUsers: featuredUserGuard.array(),
            })
            .partial()
        ) satisfies z.ZodType<OrganizationWithFeatured>
      ).array(),
      status: [200],
    }),
    async (ctx, next) => {
      const { query } = ctx.guard;
      const search = parseSearchOptions(['id', 'name'], query);
      const { limit, offset } = ctx.pagination;
      const [count, entities] = await organizations.findAll(limit, offset, search);

      ctx.pagination.totalCount = count;
      ctx.body = yes(query.showFeatured)
        ? await Promise.all(
            entities.map(async (entity) => {
              const [usersCount, featuredUsers] = await organizations.relations.users.getFeatured(
                entity.id
              );
              return { ...entity, usersCount, featuredUsers };
            })
          )
        : entities;
      return next();
    }
  );

  // MARK: Organization - user relation routes
  router.addRelationRoutes(organizations.relations.users, undefined, {
    disabled: { get: true },
    hookEvent: 'Organization.Membership.Updated',
  });

  router.get(
    '/:id/users',
    koaPagination(),
    koaGuard({
      query: z.object({ q: z.string().optional() }),
      params: z.object({ id: z.string().min(1) }),
      response: userWithOrganizationRolesGuard.array(),
      status: [200, 404],
    }),
    async (ctx, next) => {
      const search = parseSearchOptions(userSearchKeys, ctx.guard.query);

      const [totalCount, entities] = await organizations.relations.users.getUsersByOrganizationId(
        ctx.guard.params.id,
        ctx.pagination,
        search
      );

      ctx.pagination.totalCount = totalCount;
      ctx.body = entities;

      return next();
    }
  );

  // MARK: Organization - user role relation routes
  router.post(
    '/:id/users/roles',
    koaGuard({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        userIds: z.string().min(1).array().nonempty(),
        organizationRoleIds: z.string().min(1).array().nonempty(),
      }),
      status: [201, 422],
    }),
    async (ctx, next) => {
      const { id } = ctx.guard.params;
      const { userIds, organizationRoleIds } = ctx.guard.body;

      await organizations.relations.usersRoles.insert(
        ...organizationRoleIds.flatMap((roleId) =>
          userIds.map((userId) => ({ organizationId: id, organizationRoleId: roleId, userId }))
        )
      );

      ctx.status = 201;
      return next();
    }
  );

  userRoleRelationRoutes(router, organizations);

  if (EnvSet.values.isDevFeaturesEnabled) {
    // MARK: Organization - application relation routes
    router.addRelationRoutes(organizations.relations.apps, undefined, {
      hookEvent: 'Organization.Membership.Updated',
    });

    // MARK: Organization - application role relation routes
    applicationRoleRelationRoutes(router, organizations);
  }

  // MARK: Just-in-time provisioning
  emailDomainRoutes(router, organizations);
  router.addRelationRoutes(organizations.jit.roles, 'jit/roles', { isPaginationOptional: true });
  router.addRelationRoutes(organizations.jit.ssoConnectors, 'jit/sso-connectors', {
    isPaginationOptional: true,
  });

  // MARK: Mount sub-routes
  organizationRoleRoutes(...args);
  organizationScopeRoutes(...args);
  organizationInvitationRoutes(...args);

  // Add routes to the router
  originalRouter.use(router.routes());
}
