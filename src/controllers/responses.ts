import { Branch } from '../models/Branch.model';
import { User } from '../models/User.model';

export function toUserResponse(user: User) {
    return {
        id: user.getId(),
        email: user.getEmail(),
        fullName: user.getFullName(),
        role: user.getRole(),
        isActive: user.isActive(),
        hasPassword: user.hasPassword(),
        deactivatedAt: user.getDeactivatedAt(),
        createdAt: user.getCreatedAt(),
        updatedAt: user.getUpdatedAt(),
    };
}

export function toBranchResponse(branch: Branch) {
    return {
        id: branch.getId(),
        code: branch.getCode(),
        name: branch.getName(),
        isActive: branch.isActive(),
        createdAt: branch.getCreatedAt(),
    };
}
